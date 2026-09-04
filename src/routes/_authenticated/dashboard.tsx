import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/dashboard")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/link${location.searchStr}${location.hash}` });
  },
});
