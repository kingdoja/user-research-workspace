"use client";

import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState, useTransition } from "react";

export function SignInForm({ callbackUrl = "/newstudy" }: { callbackUrl?: string }) {
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage("");

    startTransition(async () => {
      try {
        const response = await fetch("/api/auth/signin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: form.get("email"),
            password: form.get("password"),
            callbackUrl,
          }),
        });
        const result = (await response.json()) as { error?: string; redirectTo?: string };

        if (!response.ok || !result.redirectTo) {
          setMessage(result.error ?? "暂时无法登录");
          return;
        }

        window.location.assign(result.redirectTo);
      } catch {
        setMessage("网络连接失败，请稍后重试");
      }
    });
  }

  return (
    <form className="sign-in-card" onSubmit={handleSubmit}>
      <h1>登录</h1>
      <p>进入您的研究工作区</p>
      <label>
        <span className="sr-only">邮箱地址</span>
        <input name="email" type="email" required placeholder="您的邮箱地址" autoComplete="email" />
      </label>
      <label className="password-field">
        <span className="sr-only">密码</span>
        <input
          name="password"
          type={showPassword ? "text" : "password"}
          required
          placeholder="您的密码"
          autoComplete="current-password"
        />
        <button
          type="button"
          onClick={() => setShowPassword((value) => !value)}
          aria-label={showPassword ? "隐藏密码" : "显示密码"}
        >
          {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </label>
      <button className="forgot-link" type="button" disabled>
        忘记密码？
      </button>
      <button className="button sign-in-primary" type="submit" disabled={pending}>
        {pending ? <LoaderCircle className="spin" size={17} /> : null}
        {pending ? "正在登录" : "登录"}
      </button>
      <p className="signup-copy">
        还没有账号？ <Link href={`/auth/signup?callbackUrl=${encodeURIComponent(callbackUrl)}`}>立即注册</Link>
      </p>
      {message ? <p className="form-status form-error" role="alert">{message}</p> : null}
    </form>
  );
}
