"use client";

import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState } from "react";

export function SignInForm() {
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("登录接口尚未迁移，表单数据未发送。");
  }

  return (
    <form className="sign-in-card" onSubmit={handleSubmit}>
      <h1>登录</h1>
      <p>请输入您的登录信息</p>
      <label>
        <span className="sr-only">邮箱地址</span>
        <input type="email" required placeholder="您的邮箱地址" autoComplete="email" />
      </label>
      <label className="password-field">
        <span className="sr-only">密码</span>
        <input
          type={showPassword ? "text" : "password"}
          required
          placeholder="您的密码"
          autoComplete="current-password"
        />
        <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label="切换密码可见性">
          {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </label>
      <button className="forgot-link" type="button">忘记密码？</button>
      <button className="button sign-in-primary" type="submit">登录</button>
      <div className="divider"><span>或者通过以下方式</span></div>
      <button className="button social-button" type="button" onClick={() => setMessage("Google OAuth 尚未迁移。")}>
        <span className="google-mark">G</span>谷歌账号登录
      </button>
      <button className="button social-button" type="button" onClick={() => setMessage("AWS Marketplace 登录尚未迁移。")}>
        <span className="aws-mark">⌒</span>Try Free with AWS
      </button>
      <p className="signup-copy">还没有账号？ <Link href="/auth/signup">立即注册</Link></p>
      {message ? <p className="form-status" role="status">{message}</p> : null}
    </form>
  );
}
