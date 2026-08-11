"use client";

import { Check, Infinity as InfinityIcon, TicketCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const plans = [
  {
    name: "Pro版",
    description: "经常进行深度业务分析",
    monthly: 129,
    tokens: "每月200万Token（有效期30天）",
    bonus: "每月额外赠送100万Token",
  },
  {
    name: "Max版",
    description: "进行高级商业分析",
    monthly: 329,
    tokens: "每月500万Token（有效期30天）",
    bonus: "每月额外赠送300万Token",
    popular: true,
  },
  {
    name: "Super版",
    description: "适用于大规模深度分析",
    monthly: 1299,
    tokens: "无限Token",
    bonus: "支持大规模研究任务",
    unlimited: true,
  },
];

export function PricingGrid() {
  const [yearly, setYearly] = useState(false);

  return (
    <>
      <div className="billing-toggle" aria-label="计费周期">
        <button className={!yearly ? "active" : ""} onClick={() => setYearly(false)} type="button">
          月付
        </button>
        <button className={yearly ? "active" : ""} onClick={() => setYearly(true)} type="button">
          年付 <span>节省17%</span>
        </button>
      </div>
      <div className="pricing-grid">
        {plans.map((plan) => {
          const price = yearly ? Math.round(plan.monthly * 0.83) : plan.monthly;
          return (
            <article className="pricing-card" key={plan.name}>
              {plan.popular ? <div className="popular-label">MOST POPULAR</div> : null}
              <h2>{plan.name}</h2>
              <p>{plan.description}</p>
              <div className="price">¥{price}<span>/月</span></div>
              <div className="plan-line">
                {plan.unlimited ? <InfinityIcon size={17} /> : <TicketCheck size={17} />}
                {plan.tokens}
              </div>
              <div className="plan-line"><TicketCheck size={17} />{plan.bonus}</div>
              <Link className="button pricing-button" href="/auth/signin">升级到{plan.name}</Link>
              <ul>
                <li><Check size={17} />支持多模态输入分析和洞察</li>
                <li><Check size={17} />研究任务、AI 人设与智能访谈</li>
                <li><Check size={17} />生成可分享的结构化报告</li>
              </ul>
            </article>
          );
        })}
      </div>
    </>
  );
}
