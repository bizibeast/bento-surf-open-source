import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/scheduler")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/post-scheduler${location.searchStr}${location.hash}` });
  },
});
