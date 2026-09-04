import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/bookings")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/calendar${location.searchStr}${location.hash}` });
  },
});
