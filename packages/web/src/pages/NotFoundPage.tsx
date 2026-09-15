import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found">
        <p>This page doesn't exist.</p>
      </PageHeader>
      <Link to="/" className="text-accent hover:underline">
        Go to your library
      </Link>
    </>
  );
}
