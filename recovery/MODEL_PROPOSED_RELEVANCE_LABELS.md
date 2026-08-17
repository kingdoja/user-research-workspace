# Model-Proposed Relevance Labels

Status: `model_proposed`, pending researcher review.

This file is a review aid only. It is not a human relevance dataset and must
not be imported into `context_evaluation_cases` as `human_annotated` without
an authorized researcher's independent review of every source chunk.

All suggestions target the approved, active, consent-confirmed, redacted human
research sample chunks imported from Zenodo `10.5281/zenodo.17484327`. The
suggested `Top K` is `8` for every case.

| # | Query | Asset / chunk | Proposed reason | Confidence |
| --- | --- | --- | --- | --- |
| 1 | 学生如何用 ChatGPT 理解 Java 的 NullPointerException？ | P1 `cxc_SraOljxPGWOWsyPU` | 直接讨论 GPT 对 NPE 原因与修复方式的解释。 | 0.93 |
| 2 | 缺少源代码时，学生为什么认为 ChatGPT 无法帮助调试？ | P10 `cxc_sUSrRDj9Cf8opuyr` | 明确说明没有源代码会限制 GPT 的调试帮助。 | 0.98 |
| 3 | 学生为什么觉得把完整上下文交给 GPT 来调试不划算？ | P11 `cxc_jKYYBm8FkfVYabhZ` | 描述完整 context 的输入成本与调试效用之间的权衡。 | 0.97 |
| 4 | 学生如何根据 GPT 的调试建议逐步验证代码修改？ | P12 `cxc_Kqt6ve7wC2tWfmoy` | 描述根据新的 error 继续判断 GPT 建议的工作流。 | 0.92 |
| 5 | 为何学生会把 controller、错误和完整调用流程一起发给 ChatGPT？ | P13 `cxc_3ibxhWiR3NZhXaxU` | 说明孤立错误会让 GPT 猜测，因此补充完整 flow。 | 0.98 |
| 6 | 学生在使用 ChatGPT 前如何先追踪程序错误源头？ | P14 `cxc_x6F8aEBgFXn5SWzF` | 说明先用 traceback 定位，再决定给 GPT 哪些信息。 | 0.94 |
| 7 | 学生怎样核验 ChatGPT 对 NullPointerException 的解释是否正确？ | P15 `cxc_4ciRS9wqfJdOWSOf` | 明确表达先验证建议，而不是直接采纳。 | 0.95 |
| 8 | 学生为什么难以向 ChatGPT 提出有效的代码调试问题？ | P16 `cxc_MS2oCnydY70AM8vT` | 讨论如何 formulate question 以及担心获得泛泛答案。 | 0.94 |
| 9 | 学生如何把 ChatGPT 的诊断作为自己判断的确认？ | P17 `cxc_xtvDQGM1ZK-LGC0g` | 已大致定位问题，GPT 的回答用于确认判断。 | 0.98 |
| 10 | 喜欢自己排查问题的学生为什么仍会尝试用 ChatGPT？ | P18 `cxc_jkTX1wB84FaXHoHY` | 呈现自主排查偏好和任务要求使用 GPT 的冲突。 | 0.96 |
| 11 | 调试时应向 ChatGPT 提供哪些错误信息和代码上下文？ | P19 `cxc_v58VBA-C7x-h9M2h` | 直接列出 error、test code、whole class 和报错行。 | 0.99 |
| 12 | 为什么学生会把 ChatGPT 的修复建议当作线索而不是最终方案？ | P2 `cxc_8ksmbhyS2hkMiHBJ` | 描述建议可能引入新 error 或不能实际改变代码。 | 0.98 |
| 13 | 学生如何分段向 ChatGPT 提交代码和错误信息？ | P20 `cxc_lcfZQMcr-FAHT3cZ` | 描述先解释任务、再提交 error 的分段 prompt 策略。 | 0.97 |
| 14 | 学生面对 ChatGPT 的代码建议时会手动修改还是直接替换？ | P3 `cxc_rFovAugZYrLObWOh` | 明确表示即使小改动也手动编辑。 | 0.96 |
| 15 | 学生如何判断 ChatGPT 的调试回答是否好用？ | P4 `cxc_WNmfyFvjo3GckbgA` | 受访者明确以“收到想要的信息、没有太多绕弯”为正向判断，并以“太长、不够明确”为反向判断。 | 0.99 |
| 16 | 学生如何从 GPT 的解释中理解未初始化 map 导致的错误？ | P5 `cxc_KUPLjrxiXhUbwnET` | 识别在初始化前向 map 添加内容导致的 NPE 根因。 | 0.97 |
| 17 | 不熟悉代码库时，学生希望 ChatGPT 提供什么调试帮助？ | P6 `cxc_HzW9e629YWyMQW-P` | 请求 GPT 先建议如何认识应用和代码库。 | 0.92 |
| 18 | 学生在提问 ChatGPT 前为什么要先查看 service 和 controller？ | P7 `cxc_TzA0cWZAd242MrEH` | 描述提问前收集相关代码与错误上下文的策略。 | 0.96 |
| 19 | 有些学生为什么只因任务要求才使用 ChatGPT 调试？ | P8 `cxc_tZPJ40d7IR0410UL` | 明确说 GPT 使用是 mandatory，而非个人偏好。 | 0.99 |
| 20 | 学生如何分段阅读 ChatGPT 的调试建议并决定是否继续？ | P9 `cxc_J-FU6UIacb_57bNc` | 描述先尝试部分建议、无效再读取后续内容。 | 0.98 |

## Review protocol

1. Open the selected source chunk and its surrounding transcript context.
2. Confirm the chunk directly answers the query without relying on inference.
3. Edit the query or discard the proposal when it is too leading, overly close
   to the source wording, or not a realistic research retrieval query.
4. Record a concise, independent reason in the Context evaluation workspace.
5. Save only approved cases as human labels. Do not copy the `model_proposed`
   status or confidence into the human-label record.

P4 was replaced after surrounding-transcript review because the earlier error-log
proposal depended on interviewer guidance and ended mid-sentence. The replacement
contains the participant's direct positive and negative response-quality criteria;
it still requires the same independent researcher confirmation as every other row.
