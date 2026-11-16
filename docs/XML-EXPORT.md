# Timeline XML export

The Export panel's «Экспортировать XML» button downloads a Final Cut Pro 7 XML
interchange document (`xmeml` version 5), not the unrelated modern FCPXML format.
It is intended for Adobe Premiere Pro and DaVinci Resolve's FCP 7 XML importers.

## Import and relink

1. Export XML from the edited project.
2. Import it into Premiere Pro (File → Import) or Resolve (File → Import → Timeline).
3. Use the editor's Locate/Relink command to select the original video and every
   used title/intro file. Keep the original filenames, including their extensions.

The browser cannot discover absolute filesystem paths. The XML contains offline
`file://localhost/<percent-encoded-original-filename>` references, not real known
paths, browser blob URLs, or rendered videos. Media bytes are not copied into XML.
If different source files have identical names, select the correct file for each
reference manually. Distinct title assets still get distinct XML file IDs.

## What is exported

- The project's **composite output timeline**: kept main-video segments, interleaved
  with the actually inserted and trimmed title clips, in their output order.
- Only the kept source ranges. Removed gaps are not represented as empty timeline
  space. Each next clip starts exactly at the previous clip's end frame.
- Linked original video/audio with each available audio channel mapped separately.
  Titles with no audio remain silent for their duration; that is not a timeline gap.
- Main-source frame rate and sequence dimensions; title media retains its own
  dimensions/rate. Media is not transcoded. Different-size titles may need the NLE's
  Fit/Scale-to-frame setting; exact browser-renderer scaling is not encoded.
- Original unprocessed audio. Gain, loudness processing, restoration, muted words,
  crossfades, and other audio effects are deliberately not translated.

XML does not automatically join «Сохранить всё»: it is a separate export action.

## Frame precision

XML edit points are integer frames, while the application's edit points are seconds.
Source starts round **up** and ends **down** to retain only whole frames within kept
ranges; removed material is never deliberately restored by outward rounding.
This can shorten each edge by less than one source frame. Subframe fragments with
no complete frame are omitted and the export toast reports their count.

Sequence positions are built from accumulated retained durations, quantized to the
sequence frame grid. They are contiguous, including when title rates differ. Source
`in/out` and file durations use explicit source rates; sequence `start/end` use the
sequence rate. NTSC rates use the exact `timebase * 1000 / 1001` rational (not a
rounded decimal). Unsupported fractional rate values are rejected with a conversion
hint, rather than silently rounded to another rate. VFR footage can nevertheless
have a standard nominal frame rate and pass this check: VFR is **not detected or
supported**. Use constant-frame-rate originals. This is not a general VFR conformer
and cannot inspect source per-frame timestamps from metadata alone.

## Implementation and validation

- `src/export/xml.ts`: browser-independent serializer and frame/rate validation.
- `src/ui/ExportPanel.tsx`: snapshot of current timeline + download/error handling.
- `src/lib/titles.ts`: original title filename from stored handle/File, never an
  invented extension based on the title's display name. Old library entries work.
- `tests/xml.test.ts` + `tests/verify_xml.py`: unit tests plus Python stdlib XML
  parsing, file/link identity, frame bounds, and track continuity checks.
- `tests/xml-export.mjs`: browser-level export/download checks.

The format follows Apple's [FCP XML encoding examples](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Basics/Basics.html),
[element catalog](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html),
and the explicit mixed-rate approach in [OpenTimelineIO's FCP adapter](https://github.com/OpenTimelineIO/otio-fcp-adapter).

Run `npm test` for the core and 52 XML unit/structural cases (Python 3 required).
Against the built preview on port 5200, run:

```bash
npm run build
npx vite preview --host 127.0.0.1 --port 5200 --strictPort
node tests/xml-export.mjs /path/to/video.mp4 --url=http://127.0.0.1:5200/
```

The test needs a short video fixture; see `tests/fixtures/README.md`.

Verified Chrome download: four packed video clips and four linked mono audio clips,
including one trimmed title; 50 sequence frames. The test also verifies filename
persistence after reload, disabled states, error recovery, and always-visible warnings.
Screenshots were captured, but visual review was unavailable in this agent session.

Independent check: OpenTimelineIO 0.18.1 + otio-fcp-adapter 1.0.0 imported a generated
25 fps main / 30 fps title sequence as exactly 5 seconds, with correct main/title/main
source starts (1, 0.5, 8 seconds), durations (2, 1, 2 seconds), and video + two audio
tracks. Structural and independent-parser tests are **not** a substitute for an
actual Premiere/Resolve import test; neither application is available on this VPS.
