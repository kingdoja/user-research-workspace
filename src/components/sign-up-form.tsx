"use client";

import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState, useTransition } from "react";

export function SignUpForm({ callbackUrl = "/newstudy" }: { callbackUrl?: string }) {
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage("");

    startTransition(async () => {
      try {
        const response = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.get("name"),
            email: form.get("email"),
            password: form.get("password"),
            callbackUrl,
          }),
        });
        const result = (await response.json()) as { error?: string; redirectTo?: string };

        if (!response.ok || !result.redirectTo) {
          setMessage(result.error ?? "暂时无法注册");
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
      <h1>注册</h1>
      <p>创建本地 atypica.AI 研究工作区</p>
      <label>
        <span className="sr-only">姓名</span>
        <input name="name" required minLength={2} placeholder="您的姓名" autoComplete="name" />
      </label>
      <label>
        <span className="sr-only">邮箱地址</span>
        <input name="email" type="email" required placeholder="您的邮箱地址" autoComplete="email" />
      </label>
      <label>
        <span className="sr-only">密码</span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          maxLength={128}
          placeholder="设置密码，至少 8 个字符"
          autoComplete="new-password"
        />
      </label>
      <button className="button sign-in-primary signup-submit" type="submit" disabled={pending}>
        {pending ? <LoaderCircle className="spin" size={17} /> : null}
        {pending ? "正在创建" : "立即注册"}
      </button>
      <p className="signup-copy">
        已有账号？ <Link href={`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`}>返回登录</Link>
      </p>
      {message ? <p className="form-status form-error" role="alert">{message}</p> : null}
    </form>
  );
}
