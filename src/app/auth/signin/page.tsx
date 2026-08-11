import { SignInForm } from "@/components/sign-in-form";
import { SiteHeader } from "@/components/site-header";
import { safeCallbackPath } from "@/lib/request-security";

export default async function SignInPage({ searchParams }: PageProps<"/auth/signin">) {
  const callbackUrl = safeCallbackPath((await searchParams).callbackUrl as string | undefined);

  return (
    <div className="site-shell signin-shell">
      <SiteHeader />
      <main className="signin-page site-container">
        <SignInForm callbackUrl={callbackUrl} />
      </main>
    </div>
  );
}
