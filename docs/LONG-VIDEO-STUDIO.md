# Long Video Studio

ALO's Video Pipeline now includes an asynchronous narrated-video mode for jobs from 1 to 60 minutes. It is designed for long lessons and explainers that would be unreliable in one HTTP render request.

## User workflow

1. Open **Video Pipeline → দীর্ঘ ভিডিও তৈরি করুন**.
2. Enter a title, choose a target duration (1–60 minutes), choose a local voice, and provide the complete narration script.
3. Start the job. The page polls its owner-scoped status and can be refreshed; the server worker continues independently of the browser request.
4. After all segments pass validation, the service joins them into one final MP4. The UI previews and offers only that final file/link. Temporary clip and audio files are removed after successful merge.

The renderer deliberately does not recycle generic filler text. If the measured speech is shorter than 95% of the requested duration, the job fails and asks for more original narration. Longer narration is capped at the requested duration. For 60 minutes, provide a script long enough for an hour at the selected voice's measured speaking pace (typically several thousand words); the estimate in the form is only approximate.

## Rendering behavior

- Local speech uses the existing local Piper/eSpeak/built-in fallback chain.
- FFmpeg creates 1280×720 H.264/AAC title-and-caption-card clips in contiguous two-minute chunks and merges them using the concat demuxer.
- `ffprobe` validates every clip and the final MP4 before the job is marked complete.
- Intermediate output lives under a private per-job work directory and is deleted on success/failure. Only the final `video_<uuid>.mp4` is returned as media.
- A single active long-video job per owner is allowed to limit CPU and disk contention.

**Visual scope:** this mode produces branded text-led narration cards, not generated live-action footage or a photo slideshow. Use the existing Photo → Video Studio for motion-animated photos and short-form scenes. The job can require substantial CPU, disk space, and time; 60-minute output has not been production-capacity tested on every deployment host.

## Runtime requirements and deployment

- Node.js 22 with `--experimental-strip-types` support, FFmpeg, FFprobe, writable `VIDEO_DIR` (or `storage/videos`), and the local speech fallback.
- `npm run build` copies the standalone worker and its two runtime TypeScript helpers into `.next/standalone` for Docker/standalone deployments.
- The app server must permit detached child workers and keep the same writable video directory mounted across restarts. A server restart can interrupt an active job; such an interrupted job may need to be retried.
- Job status is owner-scoped through `/api/video/long?jobId=...`; starting a job uses `POST /api/video/long`. The final file is streamed by the existing media route.

A successful local worker smoke test validates the clip-render/merge path, but it does not establish that every production host can encode a full 60-minute video within its storage, CPU, process-lifetime, or cPanel limits. Benchmark the actual deployment host with a disposable long job before promising an hour-long turnaround.
