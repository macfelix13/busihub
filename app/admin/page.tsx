import { redirect } from "next/navigation";

/** /admin has nothing of its own to show yet — the businesses list is the
 *  only page in this console so far. A bare redirect keeps the URL people
 *  will actually bookmark (/admin) working once there is more than one. */
export default function AdminIndexPage() {
  redirect("/admin/businesses");
}