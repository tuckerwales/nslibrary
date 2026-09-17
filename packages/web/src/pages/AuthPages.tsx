import { type FormEvent, type ReactNode, useState } from "react";
import { useLogin, useSetup } from "../api";
import { Button } from "../components/Button";
import { ContentStrip } from "../components/ContentStrip";
import { ErrorText } from "../components/Feedback";
import { Field } from "../components/Field";
import { usePageTitle } from "../format";

function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  usePageTitle(title);
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <main className="w-full max-w-sm">
        <p className="text-3xl leading-none font-bold condensed">NSLibrary</p>
        <div className="mt-3" aria-hidden="true">
          <ContentStrip
            app={{ hasBase: true, updateVersions: [196608], addonCount: 2, flags: [] }}
          />
        </div>
        <h1 className="mt-10 text-xl">{title}</h1>
        <p className="mt-1 text-muted">{description}</p>
        {children}
      </main>
    </div>
  );
}

function FormError({ message }: { message: string | undefined }) {
  return <ErrorText className="text-sm">{message}</ErrorText>;
}

export function SetupPage({ tokenRequired = false }: { tokenRequired?: boolean }) {
  const setup = useSetup();
  const [setupToken, setSetupToken] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setup.mutate({ username, password, ...(tokenRequired ? { setupToken } : {}) });
  };

  return (
    <AuthLayout
      title="Create your admin account"
      description="You'll use this account to manage your library. Only one account is needed."
    >
      <form className="mt-6 space-y-4" onSubmit={submit}>
        {tokenRequired && (
          <Field
            label="Setup token"
            autoComplete="off"
            hint="The NSLIB_SETUP_TOKEN value this server was started with"
            required
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
          />
        )}
        <Field
          label="Username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters"
          required
          minLength={8}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setMismatch(false);
          }}
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          aria-invalid={mismatch || undefined}
          onChange={(e) => {
            setConfirm(e.target.value);
            setMismatch(false);
          }}
        />
        <FormError message={mismatch ? "The passwords don't match." : setup.error?.message} />
        <Button type="submit" className="w-full" disabled={setup.isPending}>
          {setup.isPending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function LoginPage() {
  const login = useLogin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ username, password });
  };

  return (
    <AuthLayout title="Sign in" description="Sign in to manage your library.">
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <Field
          label="Username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FormError message={login.error?.message} />
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
