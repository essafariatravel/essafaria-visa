import { logoutAction } from "@/app/admin/actions";

export function LogoutForm() {
  return (
    <form action={logoutAction} className="inline">
      <button type="submit" className="hover:text-white">
        Sign out
      </button>
    </form>
  );
}
