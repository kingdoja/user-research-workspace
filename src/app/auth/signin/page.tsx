import { SignInForm } from "@/components/sign-in-form";
import { SiteHeader } from "@/components/site-header";

export default function SignInPage() {
  return (
    <div className="site-shell signin-shell">
      <SiteHeader />
      <main className="signin-page site-container">
        <SignInForm />
      </main>
    </div>
  );
}
