import { SignUpForm } from "@/components/sign-up-form";
import { SiteHeader } from "@/components/site-header";
import { safeCallbackPath } from "@/lib/request-security";

export default async function SignUpPage({ searchParams }: PageProps<"/auth/signup">) {
  const callbackUrl = safeCallbackPath((await searchParams).callbackUrl as string | undefined);

  return (
    <div className="site-shell signin-shell">
      <SiteHeader />
      <main className="signin-page site-container">
        <SignUpForm callbackUrl={callbackUrl} />
      </main>
    </div>
  );
}
