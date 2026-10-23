import { redirect } from "next/navigation";

// The API key now lives in the single "AI connection" form.
export default function ApiKeysRedirect(): never {
  redirect("/settings/providers");
}
