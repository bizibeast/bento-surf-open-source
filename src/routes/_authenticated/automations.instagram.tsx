import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/automations/instagram")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/auto-dms/instagram${location.searchStr}${location.hash}` });
  },
});
