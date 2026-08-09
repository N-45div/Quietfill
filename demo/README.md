# Demo recording

`record-demo.mjs` drives the **hosted app** through a complete auction and
records the browser. Every transaction is real: the script injects an EIP-1193
provider that signs with a funded Coston2 key, so the video is a genuine run,
not a mock-up. There is no narration track — scene captions are overlaid
instead, leaving room for a voiceover.

```bash
npm i playwright viem && npx playwright install chromium
DEMO_PRIVATE_KEY=0x<funded coston2 key> node record-demo.mjs
```

Output lands in `demo-out/`: `raw.webm` plus `marks.json` with the offset of
each scene.

## Editing

The only slow stretch is between the `cleared` and `settled` marks, while the
enclave produces its signed result. Speed just that segment, and label it so
the edit is honest:

```bash
cp /c/Windows/Fonts/consola.ttf f.ttf
ffmpeg -i raw.webm -filter_complex "\
[0:v]trim=0:135,setpts=PTS-STARTPTS[a];\
[0:v]trim=135:195,setpts=(PTS-STARTPTS)/5[b];\
[0:v]trim=195,setpts=PTS-STARTPTS[c];\
[a][b][c]concat=n=3:v=1[cv];\
[cv]drawtext=fontfile=f.ttf:text='5x speed - waiting for the enclave':\
fontcolor=white@0.8:fontsize=20:x=w-tw-30:y=30:box=1:boxcolor=black@0.55:\
boxborderw=10:enable='between(t,135,147)'[v]" \
  -map "[v]" -c:v libx264 -crf 20 -pix_fmt yuv420p -r 25 -movflags +faststart \
  quietfill-demo.mp4
```

Adjust the three trim boundaries to your run's `marks.json`.

## Before recording

tee-node regenerates its identity on every restart, so a restarted proxy serves
a TEE the registry no longer pins — the app then (correctly) refuses to
encrypt. The script preflights this and aborts rather than wasting a take. To
recover:

1. Re-run `./scripts/post-build.sh` with `EXT_PROXY_URL` set to the public URL.
2. Retire the stale machine so auctions stop pinning it:
   `cast send 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE "pause(address)" <staleTee> --private-key <owner>`
3. Confirm only the live machine remains:
   `cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE "getActiveTeeMachines(uint256)(address[])" 66046`

Recorded footage is gitignored — upload it rather than committing it.
