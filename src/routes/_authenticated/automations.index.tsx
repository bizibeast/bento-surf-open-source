import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/automations/")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/auto-dms${location.searchStr}${location.hash}` });
  },
});
