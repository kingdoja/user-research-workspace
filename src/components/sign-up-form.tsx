"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

export function SignUpForm() {
  const [message, setMessage] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("注册接口尚未迁移，表单数据未发送。");
  }

  return (
    <form className="sign-in-card" onSubmit={handleSubmit}>
      <h1>注册</h1>
      <p>创建您的 atypica.AI 账号</p>
      <label><span className="sr-only">姓名</span><input required placeholder="您的姓名" autoComplete="name" /></label>
      <label><span className="sr-only">邮箱地址</span><input type="email" required placeholder="您的邮箱地址" autoComplete="email" /></label>
      <label><span className="sr-only">密码</span><input type="password" required minLength={8} placeholder="设置密码" autoComplete="new-password" /></label>
      <button className="button sign-in-primary signup-submit" type="submit">立即注册</button>
      <p className="signup-copy">已有账号？ <Link href="/auth/signin">返回登录</Link></p>
      {message ? <p className="form-status" role="status">{message}</p> : null}
    </form>
  );
}
