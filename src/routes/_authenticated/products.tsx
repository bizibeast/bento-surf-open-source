import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/products")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/store${location.searchStr}${location.hash}` });
  },
});
