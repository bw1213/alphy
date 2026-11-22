import { redirect } from "next/navigation";

export default function AutoRedirect() {
  redirect("/accounts?id=kis");
}
