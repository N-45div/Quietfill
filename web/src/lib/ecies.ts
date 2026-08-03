/**
 * ECIES compatible with go-ethereum's crypto/ecies as used by Flare's
 * tee-node (utils.Encrypt / the TEE /decrypt endpoint):
 *
 *   curve      secp256k1
 *   params     ECIES_AES128_SHA256
 *   KDF        NIST SP 800-56 concat KDF over the shared X coordinate
 *   cipher     AES-128-CTR, random 16-byte IV
 *   MAC        HMAC-SHA256 over IV||ciphertext, key = SHA256(K[16:32])
 *   wire       R(65, uncompressed) || IV(16) || ciphertext || MAC(32)
 *
 * A bid encrypted here decrypts byte-for-byte inside the TEE. Do not
 * change any step without changing the pinned tee-node revision.
 */

import { ctr } from "@noble/ciphers/aes";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, randomBytes } from "@noble/hashes/utils";

const PUBKEY_LEN = 65; // uncompressed SEC1: 0x04 || X || Y
const IV_LEN = 16;
const MAC_LEN = 32;

/** Overhead every ciphertext carries: ephemeral pubkey + IV + MAC. */
export const ECIES_OVERHEAD = PUBKEY_LEN + IV_LEN + MAC_LEN;

function deriveKeys(sharedX: Uint8Array): { enc: Uint8Array; mac: Uint8Array } {
  // concat KDF, one round: SHA256(counter=1 (be32) || Z) yields the full
  // 32 bytes needed for AES-128 + MAC key material.
  const k = sha256(concatBytes(new Uint8Array([0, 0, 0, 1]), sharedX));
  return { enc: k.slice(0, 16), mac: sha256(k.slice(16, 32)) };
}

/** Shared-secret X coordinate for our key and their point, left-padded. */
function sharedX(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const point = secp256k1.getSharedSecret(privateKey, publicKey, false);
  return point.subarray(1, 33);
}

/** Encrypts plaintext to an uncompressed (65-byte) secp256k1 public key. */
export function eciesEncrypt(recipient: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (recipient.length !== PUBKEY_LEN || recipient[0] !== 0x04) {
    throw new Error("recipient must be an uncompressed 65-byte secp256k1 public key");
  }
  const ephemeral = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeral, false);
  const { enc, mac } = deriveKeys(sharedX(ephemeral, recipient));

  const iv = randomBytes(IV_LEN);
  const ciphertext = ctr(enc, iv).encrypt(plaintext);
  const em = concatBytes(iv, ciphertext);
  const tag = hmac(sha256, mac, em);
  return concatBytes(ephemeralPub, em, tag);
}

/** Decrypts an ECIES payload. Used by tests to prove a clean round trip. */
export function eciesDecrypt(privateKey: Uint8Array, payload: Uint8Array): Uint8Array {
  if (payload.length < ECIES_OVERHEAD + 1) throw new Error("ciphertext too short");
  const ephemeralPub = payload.slice(0, PUBKEY_LEN);
  const em = payload.slice(PUBKEY_LEN, payload.length - MAC_LEN);
  const tag = payload.slice(payload.length - MAC_LEN);
  const { enc, mac } = deriveKeys(sharedX(privateKey, ephemeralPub));

  const expected = hmac(sha256, mac, em);
  let diff = 0;
  for (let i = 0; i < MAC_LEN; i++) diff |= expected[i] ^ tag[i];
  if (diff !== 0) throw new Error("MAC mismatch");

  return ctr(enc, em.slice(0, IV_LEN)).decrypt(em.slice(IV_LEN));
}
