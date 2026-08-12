"use client";

import { Check, Copy, Link2, LoaderCircle, Share2, X } from "lucide-react";
import { useState, useTransition } from "react";

export function StudyShareControls({
  publicId,
  initialEnabled,
  initialToken,
}: {
  publicId: string;
  initialEnabled: boolean;
  initialToken: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [shareToken, setShareToken] = useState(initialToken);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const sharePath = shareToken ? `/shared/${shareToken}` : null;

  function updateShare(nextEnabled: boolean) {
    setError("");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/studies/${publicId}/share`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        const result = await response.json() as { error?: string; shareUrl?: string | null };
        if (!response.ok) {
          setError(result.error ?? "暂时无法更新分享设置");
          return;
        }
        setEnabled(nextEnabled);
        setShareToken(result.shareUrl?.split("/").at(-1) ?? null);
        setCopied(false);
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  function copyShareLink() {
    if (!sharePath) return;
    startTransition(async () => {
      try {
        await navigator.clipboard.writeText(new URL(sharePath, window.location.origin).toString());
        setCopied(true);
      } catch {
        setError("无法写入剪贴板，请直接打开链接后复制地址");
      }
    });
  }

  return (
    <div className="study-share-control">
      <button type="button" onClick={() => setOpen(true)}><Share2 size={17} />分享回放</button>
      {open ? (
        <section className="study-share-dialog" role="dialog" aria-modal="true" aria-label="报告分享设置">
          <header><div><Share2 size={18} /><strong>分享研究报告</strong></div><button type="button" onClick={() => setOpen(false)} aria-label="关闭分享设置"><X size={18} /></button></header>
          <div className="study-share-body">
            <p>创建只读链接。访问者可查看报告、AI 合成 Persona 和模拟访谈摘要，不能查看账号或内部执行消息。</p>
            {enabled && sharePath ? (
              <div className="study-share-link"><Link2 size={15} /><span>{sharePath}</span><button type="button" onClick={copyShareLink}>{copied ? <Check size={15} /> : <Copy size={15} />}<span className="sr-only">复制分享链接</span></button></div>
            ) : <div className="study-share-off">当前未开放公开访问。</div>}
            <div className="study-share-actions">
              {enabled && sharePath ? <a href={sharePath} target="_blank" rel="noreferrer">打开只读页面</a> : null}
              <button type="button" disabled={pending} onClick={() => updateShare(!enabled)}>{pending ? <LoaderCircle className="spin" size={15} /> : null}{enabled ? "撤销分享" : "创建分享链接"}</button>
            </div>
            {error ? <p className="study-share-error" role="alert">{error}</p> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
