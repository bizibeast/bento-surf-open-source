import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/automations/twitter")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/auto-dms/twitter${location.searchStr}${location.hash}` });
  },
});
