# AudioWerk

AudioWerk is a small Windows desktop application for converting local audio and video files to M4A. It includes a live bass, midrange, treble, and volume preview, then applies those settings during conversion.

## Use

1. Open an audio or video file with the drop area.
2. Preview the sound and adjust the equalizer.
3. Choose **Maak M4A** and pick where to save the result.

Supported inputs include MP3, WAV, FLAC, M4A, AAC, OGG, MP4, MOV, MKV, and WebM. Conversion runs on the device. The output is AAC audio at 256 kbps in an M4A container.

Links from Spotify, YouTube, Apple Music, and SoundCloud are not imported or downloaded. Use a local file that you own or are allowed to convert.

The bundled FFmpeg executable is GPLv3 software. Its license and the matching upstream source revision are listed in `THIRD-PARTY-NOTICES.md` and `LICENSES/`.

## Build

Install Node.js on Windows, then run `npm ci` and `npm run build:windows` to create a portable x64 Windows executable in `dist/`. The GitHub Actions workflow builds the Windows app and attaches it to the `v1.0.2` release.
