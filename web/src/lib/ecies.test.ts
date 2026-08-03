import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";

import { ECIES_OVERHEAD, eciesDecrypt, eciesEncrypt } from "./ecies";

const privateKey = secp256k1.utils.randomPrivateKey();
const publicKey = secp256k1.getPublicKey(privateKey, false);

// Produced by tee-node's utils.Encrypt (go-ethereum crypto/ecies) for the
// well-known dev key below — proves this implementation decrypts what the
// real TEE stack encrypts. The forward direction (this encrypt → tee-node
// decrypt) was verified against the pinned tee-node revision in Docker.
const GO_FIXTURE_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const GO_FIXTURE_PLAINTEXT = "quietfill-ecies-crosscheck-v1";
const GO_FIXTURE_CIPHERTEXT =
  "04de2df58c73e865263ca4e9469c1b8dc8edcd1202d24de9cc7997ae48115c0a54d8c8a27d0951726aca8bfa9ffd4b93fe86c066226dd0691fc14b0cbe69812f4aadd406e58c2b01c673d6583a3c1d907f1a24b9c0d216433217c9d084a469b8d76369e2f9e074a6a43607bff9918a2c17fdc127fc437059f931b0bf4e6f3facc42dfdc733cbadcc865f6ad96960";

describe("go-ethereum-compatible ECIES", () => {
  it("round-trips arbitrary plaintext", () => {
    const plaintext = utf8ToBytes("quietfill private bid plaintext");
    const ciphertext = eciesEncrypt(publicKey, plaintext);
    expect(eciesDecrypt(privateKey, ciphertext)).toEqual(plaintext);
  });

  it("carries exactly the go-ethereum wire overhead", () => {
    const plaintext = new Uint8Array(224); // typical ABI-encoded bid tuple
    const ciphertext = eciesEncrypt(publicKey, plaintext);
    expect(ciphertext.length).toBe(plaintext.length + ECIES_OVERHEAD);
    expect(ciphertext[0]).toBe(0x04); // uncompressed ephemeral key
  });

  it("never repeats a ciphertext for the same plaintext", () => {
    const plaintext = utf8ToBytes("same bid twice");
    const a = eciesEncrypt(publicKey, plaintext);
    const b = eciesEncrypt(publicKey, plaintext);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("rejects a tampered ciphertext", () => {
    const ciphertext = eciesEncrypt(publicKey, utf8ToBytes("tamper me"));
    ciphertext[ciphertext.length - 40] ^= 0x01;
    expect(() => eciesDecrypt(privateKey, ciphertext)).toThrow("MAC mismatch");
  });

  it("decrypts a ciphertext produced by tee-node's Go implementation", () => {
    const plaintext = eciesDecrypt(
      hexToBytes(GO_FIXTURE_KEY),
      hexToBytes(GO_FIXTURE_CIPHERTEXT),
    );
    expect(new TextDecoder().decode(plaintext)).toBe(GO_FIXTURE_PLAINTEXT);
  });

  it("rejects a compressed recipient key", () => {
    const compressed = secp256k1.getPublicKey(privateKey, true);
    expect(() => eciesEncrypt(compressed, utf8ToBytes("x"))).toThrow("uncompressed");
  });
});
