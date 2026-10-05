These tiny synthetic clips test frame-rate inspection without changing the
English gameplay regression fixtures or requiring ffmpeg for unit tests.

- `fps-30.mp4`: one second of 16×16 grayscale frames at 30 fps, generated
  with `nullsrc=size=16x16:rate=30:duration=1,geq=lum=N*4+16:cb=128:cr=128`.
- `fps-59.94.mp4`: one second of 16×16 grayscale frames at 60000/1001 fps,
  using the same filter with `rate=60000/1001` and `lum=N*3+16`.
  Both grayscale clips use `-crf 0`: every source frame has a distinct gray
  level, allowing the browser test to detect repeated or skipped frames.
- `fps-variable.mp4`: ten seconds of 16×16 black video, 30 fps for the first
  nine seconds, then 60 fps. The change occurs after 256 packets, so examining
  only the opening frames would incorrectly select 30 Hz for the whole video.

Generated with ffmpeg/libx264, `-preset ultrafast -pix_fmt yuv420p
-movflags +faststart`. The variable-rate clip uses a 60 fps source with
`select=if(lt(n\,540)\,not(mod(n\,2))\,1)` and `-fps_mode vfr`.
