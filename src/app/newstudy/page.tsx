import { redirect } from "next/navigation";

export default function NewStudyPage() {
  redirect("/auth/signin?callbackUrl=%2Fnewstudy");
}
