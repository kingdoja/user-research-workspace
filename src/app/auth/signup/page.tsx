import { SignUpForm } from "@/components/sign-up-form";
import { SiteHeader } from "@/components/site-header";

export default function SignUpPage() {
  return (
    <div className="site-shell signin-shell">
      <SiteHeader />
      <main className="signin-page site-container">
        <SignUpForm />
      </main>
    </div>
  );
}
