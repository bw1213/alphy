import { redirect } from "next/navigation";

export default async function ManualRedirect({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const { account } = await searchParams;
  redirect(account ? `/accounts?id=${encodeURIComponent(account)}` : "/accounts");
}
