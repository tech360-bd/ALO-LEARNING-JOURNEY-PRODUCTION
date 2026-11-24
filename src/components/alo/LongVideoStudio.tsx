"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clapperboard, Clipboard, Download, Loader2, Video } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { LONG_VIDEO_MAX_SCRIPT_CHARS, LONG_VIDEO_MIN_SCRIPT_CHARS } from "@/lib/long-video-plan";

interface LongJob {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  stage: string;
  completedChunks: number;
  totalChunks: number;
  error?: string;
  result?: { videoUrl: string; durationSec: number; width: number; height: number; sizeBytes: number; chunkCount: number; title: string };
}

const JOB_STORAGE_KEY = "alo-long-video-job";
const VOICES = [
  { id: "bn", label: "বাংলা (bn)" },
  { id: "bn+f2", label: "বাংলা নারী (bn+f2)" },
  { id: "en", label: "English (en)" },
  { id: "en+f3", label: "English female (en+f3)" },
  { id: "hi", label: "Hindi (hi)" },
];

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function LongVideoStudio() {
  const { toast } = useToast();
  const [topic, setTopic] = useState("");
  const [script, setScript] = useState("");
  const [minutes, setMinutes] = useState("10");
  const [voice, setVoice] = useState("bn");
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState<LongJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  const estimatedMinutes = useMemo(() => {
    const words = script.trim().split(/\s+/u).filter(Boolean).length;
    return words ? words / 135 : 0;
  }, [script]);

  useEffect(() => {
    const stored = window.localStorage.getItem(JOB_STORAGE_KEY);
    if (stored) setJobId(stored);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/video/long?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(data.error ?? "Job status unavailable"));
        if (!active) return;
        const next = data.job as LongJob;
        setJob(next);
        if (next.status === "completed" || next.status === "failed") {
          window.localStorage.removeItem(JOB_STORAGE_KEY);
          if (next.status === "failed") setError(next.error ?? "ভিডিও রেন্ডার ব্যর্থ হয়েছে");
          return;
        }
      } catch (pollError) {
        if (active) setError((pollError as Error).message);
      }
      if (active) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || (job && (job.status === "queued" || job.status === "processing"))) return;
    setSubmitting(true);
    setError("");
    setJob(null);
    try {
      const response = await fetch("/api/video/long", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, script, voice, durationSec: Number(minutes) * 60 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.job?.id) throw new Error(String(data.error ?? "Long video job could not be created"));
      setJob(data.job as LongJob);
      setJobId(data.job.id);
      window.localStorage.setItem(JOB_STORAGE_KEY, data.job.id);
      toast({ title: "লং ভিডিও কাজ শুরু হয়েছে", description: "ভিডিওটি অংশে রেন্ডার হবে, শেষে একটিমাত্র MP4 দেখানো হবে।" });
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const copyFinalLink = async () => {
    if (!job?.result?.videoUrl) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${job.result.videoUrl}`);
      setShareCopied(true);
      toast({ title: "ফাইনাল MP4 লিংক কপি হয়েছে" });
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      toast({ title: "লিংক কপি করা যায়নি", description: "ভিডিও ডাউনলোড করে শেয়ার করুন।", variant: "destructive" });
    }
  };

  const busy = submitting || job?.status === "queued" || job?.status === "processing";

  return (
    <Card className="p-4 sm:p-5 space-y-4 border-amber-200/70 dark:border-amber-900/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold"><Clapperboard className="h-4 w-4 text-amber-600" /> দীর্ঘ ভিডিও তৈরি করুন</h2>
          <p className="mt-1 text-xs text-muted-foreground">১–৬০ মিনিটের narration video। সার্ভার ২-মিনিটের MP4 অংশ তৈরি করে জোড়ে, তারপর শুধু একটিমাত্র final MP4 দেয়।</p>
        </div>
        <Badge variant="outline" className="gap-1"><Video className="h-3 w-3" /> FFmpeg · local TTS</Badge>
      </div>

      <form className="space-y-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[1fr_150px_190px]">
          <div className="space-y-1.5">
            <Label htmlFor="long-video-topic">ভিডিওর শিরোনাম</Label>
            <Input id="long-video-topic" value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={160} required placeholder="যেমন: শিশুদের নিরাপদ ইন্টারনেট ব্যবহার" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="long-video-duration">সময় (মিনিট)</Label>
            <Input id="long-video-duration" type="number" min={1} max={60} step={1} value={minutes} onChange={(event) => setMinutes(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label>কণ্ঠ</Label>
            <Select value={voice} onValueChange={setVoice}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{VOICES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex flex-wrap justify-between gap-1">
            <Label htmlFor="long-video-script">সম্পূর্ণ narration script</Label>
            <span className="text-[11px] text-muted-foreground">{script.length.toLocaleString()} / {LONG_VIDEO_MAX_SCRIPT_CHARS.toLocaleString()} অক্ষর · আনুমানিক {estimatedMinutes.toFixed(1)} মিনিট</span>
          </div>
          <Textarea id="long-video-script" value={script} onChange={(event) => setScript(event.target.value.slice(0, LONG_VIDEO_MAX_SCRIPT_CHARS))} required minLength={LONG_VIDEO_MIN_SCRIPT_CHARS} rows={8} placeholder="সম্পূর্ণ মৌলিক স্ক্রিপ্ট পেস্ট করুন। ছোট স্ক্রিপ্টকে জোর করে পুনরাবৃত্তি করে ভিডিওর সময় বাড়ানো হবে না।" />
          <p className="text-[11px] text-muted-foreground">লক্ষ্য সময়ের কাছাকাছি পূর্ণ script দিন। voice-এর প্রকৃত দৈর্ঘ্য ffprobe দিয়ে মাপা হয়; script ছোট হলে renderer filler না বানিয়ে কারণ জানাবে।</p>
        </div>
        <Button type="submit" disabled={Boolean(busy) || !topic.trim() || script.trim().length < LONG_VIDEO_MIN_SCRIPT_CHARS} className="bg-amber-500 hover:bg-amber-600">
          {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> কাজ চলছে…</> : <><Clapperboard className="mr-2 h-4 w-4" /> ৬০ মিনিট পর্যন্ত তৈরি</>}
        </Button>
      </form>

      {error && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 shrink-0" /> ভিডিও সম্পন্ন হয়নি</p>
          <p className="mt-1 break-words text-xs">{error}</p>
        </div>
      )}

      {job && (job.status === "queued" || job.status === "processing") && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3" aria-live="polite">
          <div className="flex justify-between gap-2 text-xs"><span>{job.stage || "Queue"}</span><span>{job.progress}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-gradient-to-r from-amber-400 to-rose-500 transition-all" style={{ width: `${Math.max(2, Math.min(100, job.progress))}%` }} /></div>
          <p className="text-[11px] text-muted-foreground">{job.totalChunks ? `${job.completedChunks}/${job.totalChunks} ক্লিপ সম্পন্ন` : "Narration প্রস্তুত হচ্ছে"}। এই পৃষ্ঠা বন্ধ করলেও সার্ভারের কাজ চলবে; ফিরে এলে অবস্থা দেখা যাবে।</p>
        </div>
      )}

      {job?.status === "completed" && job.result && (
        <div className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50/60 p-3 dark:bg-emerald-950/20">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-200"><CheckCircle2 className="h-4 w-4" /> ফাইনাল ভিডিও প্রস্তুত · {clock(job.result.durationSec)}</p>
            <span className="text-xs text-muted-foreground">{job.result.width}×{job.result.height} · {fileSize(job.result.sizeBytes)}</span>
          </div>
          <video src={job.result.videoUrl} controls playsInline preload="metadata" className="max-h-[460px] w-full rounded-lg bg-black" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" asChild className="bg-emerald-600 hover:bg-emerald-700"><a href={job.result.videoUrl} download={`${job.result.title || "alo-long-video"}.mp4`}><Download className="mr-1.5 h-3.5 w-3.5" /> শুধু ফাইনাল MP4 ডাউনলোড</a></Button>
            <Button size="sm" variant="outline" onClick={copyFinalLink}><Clipboard className="mr-1.5 h-3.5 w-3.5" />{shareCopied ? "কপি হয়েছে" : "ফাইনাল লিংক কপি"}</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">অস্থায়ী clip ফাইলগুলো merge শেষে মুছে ফেলা হয়েছে; এখানে শুধু বড় final MP4-টাই দেখানো হচ্ছে।</p>
        </div>
      )}
    </Card>
  );
}
