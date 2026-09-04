import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/automations/facebook")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/auto-dms/facebook${location.searchStr}${location.hash}` });
  },
});
