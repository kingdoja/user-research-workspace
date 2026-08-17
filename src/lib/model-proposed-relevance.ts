/**
 * Review-only retrieval candidates. These are deliberately kept outside the
 * evaluation-set write path: a researcher must independently confirm each
 * candidate and add their own rationale before a human label is created.
 */
export const modelProposedRelevanceLabels = [
  { sourcePublicId: "cxc_SraOljxPGWOWsyPU", query: "学生如何用 ChatGPT 理解 Java 的 NullPointerException？", rationale: "直接讨论 GPT 对 NPE 原因与修复方式的解释。", confidence: 0.93, topK: 8 },
  { sourcePublicId: "cxc_sUSrRDj9Cf8opuyr", query: "缺少源代码时，学生为什么认为 ChatGPT 无法帮助调试？", rationale: "明确说明没有源代码会限制 GPT 的调试帮助。", confidence: 0.98, topK: 8 },
  { sourcePublicId: "cxc_jKYYBm8FkfVYabhZ", query: "学生为什么觉得把完整上下文交给 GPT 来调试不划算？", rationale: "描述完整 context 的输入成本与调试效用之间的权衡。", confidence: 0.97, topK: 8 },
  { sourcePublicId: "cxc_Kqt6ve7wC2tWfmoy", query: "学生如何根据 GPT 的调试建议逐步验证代码修改？", rationale: "描述根据新的 error 继续判断 GPT 建议的工作流。", confidence: 0.92, topK: 8 },
  { sourcePublicId: "cxc_3ibxhWiR3NZhXaxU", query: "为何学生会把 controller、错误和完整调用流程一起发给 ChatGPT？", rationale: "说明孤立错误会让 GPT 猜测，因此补充完整 flow。", confidence: 0.98, topK: 8 },
  { sourcePublicId: "cxc_x6F8aEBgFXn5SWzF", query: "学生在使用 ChatGPT 前如何先追踪程序错误源头？", rationale: "说明先用 traceback 定位，再决定给 GPT 哪些信息。", confidence: 0.94, topK: 8 },
  { sourcePublicId: "cxc_4ciRS9wqfJdOWSOf", query: "学生怎样核验 ChatGPT 对 NullPointerException 的解释是否正确？", rationale: "明确表达先验证建议，而不是直接采纳。", confidence: 0.95, topK: 8 },
  { sourcePublicId: "cxc_MS2oCnydY70AM8vT", query: "学生为什么难以向 ChatGPT 提出有效的代码调试问题？", rationale: "讨论如何 formulate question 以及担心获得泛泛答案。", confidence: 0.94, topK: 8 },
  { sourcePublicId: "cxc_xtvDQGM1ZK-LGC0g", query: "学生如何把 ChatGPT 的诊断作为自己判断的确认？", rationale: "已大致定位问题，GPT 的回答用于确认判断。", confidence: 0.98, topK: 8 },
  { sourcePublicId: "cxc_jkTX1wB84FaXHoHY", query: "喜欢自己排查问题的学生为什么仍会尝试用 ChatGPT？", rationale: "呈现自主排查偏好和任务要求使用 GPT 的冲突。", confidence: 0.96, topK: 8 },
  { sourcePublicId: "cxc_v58VBA-C7x-h9M2h", query: "调试时应向 ChatGPT 提供哪些错误信息和代码上下文？", rationale: "直接列出 error、test code、whole class 和报错行。", confidence: 0.99, topK: 8 },
  { sourcePublicId: "cxc_8ksmbhyS2hkMiHBJ", query: "为什么学生会把 ChatGPT 的修复建议当作线索而不是最终方案？", rationale: "描述建议可能引入新 error 或不能实际改变代码。", confidence: 0.98, topK: 8 },
  { sourcePublicId: "cxc_lcfZQMcr-FAHT3cZ", query: "学生如何分段向 ChatGPT 提交代码和错误信息？", rationale: "描述先解释任务、再提交 error 的分段 prompt 策略。", confidence: 0.97, topK: 8 },
  { sourcePublicId: "cxc_rFovAugZYrLObWOh", query: "学生面对 ChatGPT 的代码建议时会手动修改还是直接替换？", rationale: "明确表示即使小改动也手动编辑。", confidence: 0.96, topK: 8 },
  { sourcePublicId: "cxc_WNmfyFvjo3GckbgA", query: "学生如何判断 ChatGPT 的调试回答是否好用？", rationale: "受访者明确以“收到想要的信息、没有太多绕弯”为正向判断，并以“太长、不够明确”为反向判断。", confidence: 0.99, topK: 8 },
  { sourcePublicId: "cxc_KUPLjrxiXhUbwnET", query: "学生如何从 GPT 的解释中理解未初始化 map 导致的错误？", rationale: "识别在初始化前向 map 添加内容导致的 NPE 根因。", confidence: 0.97, topK: 8 },
  { sourcePublicId: "cxc_HzW9e629YWyMQW-P", query: "不熟悉代码库时，学生希望 ChatGPT 提供什么调试帮助？", rationale: "请求 GPT 先建议如何认识应用和代码库。", confidence: 0.92, topK: 8 },
  { sourcePublicId: "cxc_TzA0cWZAd242MrEH", query: "学生在提问 ChatGPT 前为什么要先查看 service 和 controller？", rationale: "描述提问前收集相关代码与错误上下文的策略。", confidence: 0.96, topK: 8 },
  { sourcePublicId: "cxc_tZPJ40d7IR0410UL", query: "有些学生为什么只因任务要求才使用 ChatGPT 调试？", rationale: "明确说 GPT 使用是 mandatory，而非个人偏好。", confidence: 0.99, topK: 8 },
  { sourcePublicId: "cxc_J-FU6UIacb_57bNc", query: "学生如何分段阅读 ChatGPT 的调试建议并决定是否继续？", rationale: "描述先尝试部分建议、无效再读取后续内容。", confidence: 0.98, topK: 8 },
] as const;

export type ModelProposedRelevanceLabel = (typeof modelProposedRelevanceLabels)[number];
