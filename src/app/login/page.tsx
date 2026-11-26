"use client";

import { FormEvent, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { ArrowRight, Heart, LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkingConfig, setCheckingConfig] = useState(true);
  const [otpRequired, setOtpRequired] = useState(false);
  const [otpAvailable, setOtpAvailable] = useState(false);
  const [otpRequested, setOtpRequested] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpMessage, setOtpMessage] = useState("");
  const [hashState, setHashState] = useState<"ok" | "missing" | "interpolated">("ok");
  const [error, setError] = useState("");
  const [setupRequired, setSetupRequired] = useState(false);

  useEffect(() => {
    let frame: number | undefined;
    if (new URLSearchParams(window.location.search).get("reason") === "setup") {
      frame = window.requestAnimationFrame(() => setSetupRequired(true));
    }
    fetch("/api/auth/otp/config", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("OTP configuration could not be checked");
        return response.json();
      })
      .then((configuration) => {
        setOtpRequired(Boolean(configuration.required));
        setOtpAvailable(Boolean(configuration.available));
        if (configuration.passwordHash === "interpolated" || configuration.passwordHash === "missing") {
          setHashState(configuration.passwordHash);
        }
        if (!configuration.authConfigured || (configuration.required && !configuration.available)) setSetupRequired(true);
      })
      .catch(() => {
        setOtpRequired(true);
        setOtpAvailable(false);
        setSetupRequired(true);
      }).finally(() => setCheckingConfig(false));
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); };
  }, []);

  async function requestOtp() {
    setOtpBusy(true);
    setError("");
    setOtpMessage("");
    try {
      const response = await fetch("/api/auth/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error === "otp_rate_limited"
        ? `Please wait ${result.retryAfterSeconds ?? 60} seconds before requesting another code.`
        : "SMS OTP is unavailable. Check the administrator SMS configuration.");
      setOtpRequested(true);
      setOtpCode("");
      setOtpMessage("If the administrator credentials are valid, a code request has been queued. SMS arrival is not confirmed.");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Could not request a sign-in code.");
    } finally {
      setOtpBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (otpRequired && !otpRequested) {
      setError("Request the SMS one-time code before signing in.");
      return;
    }
    setBusy(true);
    setError("");

    const requested = new URLSearchParams(window.location.search).get("callbackUrl");
    const callbackUrl = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/";

    try {
      const result = await signIn("credentials", {
        email,
        password,
        otp: otpRequired ? otpCode : undefined,
        redirect: false,
        callbackUrl,
      });
      if (result?.ok) {
        window.location.assign(callbackUrl);
        return;
      }
      setError("Sign-in details or one-time code were not accepted. Please try again.");
    } catch {
      setError("Sign-in could not be completed. Check the server configuration and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-orange-50/60 dark:from-background dark:to-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-blue-800 shadow-md">
            <Heart className="h-5 w-5 text-white" fill="white" />
          </div>
          <div>
            <p className="text-xl font-bold leading-tight">আলো <span className="text-blue-700 dark:text-blue-300">Learning Journey</span></p>
            <p className="mt-0.5 text-xs text-muted-foreground">Administrator sign in</p>
          </div>
        </div>

        <section className="rounded-2xl border border-border/70 bg-card/95 p-6 shadow-xl backdrop-blur sm:p-8">
          <div className="mb-6 flex items-start gap-3">
            <div className="rounded-xl bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-300">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
              <p className="mt-1 text-sm text-muted-foreground">Sign in to manage admissions, quotations, and learning campaigns.</p>
            </div>
          </div>

          {setupRequired && (
            <div className="mb-5 rounded-xl border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status">
              <p className="font-semibold">
                {hashState === "interpolated"
                  ? "Administrator sign-in rejects ADMIN_PASSWORD_HASH: dotenv rewrote it."
                  : "Administrator sign-in is not configured."}
              </p>
              <p className="mt-1 text-xs leading-relaxed">
                {otpRequired
                  ? <>Set <code>NEXTAUTH_SECRET</code>, <code>ADMIN_EMAIL</code>, an scrypt <code>ADMIN_PASSWORD_HASH</code>, <code>ADMIN_OTP_PHONE</code>, <code>HTTPSMS_API_KEY</code>, and <code>HTTPSMS_FROM</code> before enabling production access.</>
                  : <>Set <code>NEXTAUTH_SECRET</code>, <code>ADMIN_EMAIL</code>, and an scrypt <code>ADMIN_PASSWORD_HASH</code> before enabling production access. SMS OTP is switched off (<code>ADMIN_OTP_REQUIRED=false</code>), so no SMS provider is needed.</>}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed">
                {hashState === "interpolated"
                  ? <>The hash is present but its <code>$</code> separators were read as <code>$VARIABLE</code> references and deleted, so the value can no longer match. Re-write it with escaped dollars (<code>ADMIN_PASSWORD_HASH=scrypt\$…\$…</code>) or set it in the PM2 environment instead of <code>.env</code>.</>
                  : <>In a <code>.env</code> file the hash must be written with escaped dollars (<code>ADMIN_PASSWORD_HASH=scrypt\$…\$…</code>) — an unescaped hash is rewritten by dotenv interpolation and rejected.</>}{" "}
                Generate it with <code>node scripts/hash-admin-password.mjs</code>.
              </p>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="admin-email">Email address</Label>
              <Input
                id="admin-email"
                type="email"
                autoComplete="username"
                inputMode="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@example.com"
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-password">Password</Label>
              <Input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                className="h-11"
              />
            </div>

            {otpRequired && <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
              <Label htmlFor="admin-otp">SMS one-time code</Label>
              <div className="flex flex-col gap-2 sm:flex-row"><Input id="admin-otp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" className="h-11" /><Button type="button" variant="outline" disabled={!otpAvailable || otpBusy || setupRequired || !email || !password} onClick={requestOtp} className="shrink-0">{otpBusy ? "Queueing…" : "Request SMS code"}</Button></div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{otpMessage || "A code is sent only to the fixed administrator phone. SMS arrival depends on the configured HTTP SMS gateway and handset."}</p>
            </div>}

            {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}

            <Button type="submit" disabled={checkingConfig || busy || setupRequired} className="h-11 w-full bg-blue-700 text-white hover:bg-blue-800">
              {checkingConfig ? "Checking sign-in options…" : busy ? "Signing in…" : "Sign in securely"}
              {!busy && <ArrowRight className="h-4 w-4" />}
            </Button>
          </form>

          <div className="mt-5 flex items-center justify-center gap-2 border-t border-border/60 pt-4 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            <span>Protected admin workspace · no public registration</span>
          </div>
        </section>
        <p className="mt-5 text-center text-[11px] text-muted-foreground">Use only an administrator account provisioned by your organisation.</p>
      </div>
    </main>
  );
}
