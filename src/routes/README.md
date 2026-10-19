# Routes

TanStack Start uses **file-based routing**. Every `.tsx` file in this directory
is a route. Do **not** create `src/pages/`, `src/routes/_app/index.tsx`, or
`app/layout.tsx` - those are Next.js / Remix conventions. The only root layout
is `src/routes/__root.tsx`.

Analytics is configured by the instance operator. The public root does not
include a hosted Google tag. Keep any operator-configured shared tracking in
the root layout and avoid duplicate tags in individual routes.

## Conventions

| File                     | URL                                                     |
| ------------------------ | ------------------------------------------------------- |
| `index.tsx`              | `/`                                                     |
| `about.tsx`              | `/about`                                                |
| `users/index.tsx`        | `/users`                                                |
| `users/$id.tsx`          | `/users/:id` (dynamic - bare `$`, no curly braces)      |
| `posts/{-$category}.tsx` | `/posts/:category?` (optional segment)                  |
| `files/$.tsx`            | `/files/*` (splat - read via `_splat` param, never `*`) |
| `_layout.tsx`            | layout route (renders children via `<Outlet />`)        |
| `__root.tsx`             | app shell - wraps every page; preserve `<Outlet />`     |

`routeTree.gen.ts` is auto-generated. Don't edit it by hand.

## Public creator URL contract

Every public creator-owned resource belongs beneath `/@username`. Use the helpers in
`src/lib/application-urls.ts`; do not hand-build these paths.

- Profile: `/@username`
- Page: `/@username/:pageSlug`
- Product: `/@username/products/:productSlug`
- Product success: `/@username/products/:productSlug/success`

Username changes are limited to once every 30 days. The previous username remains a temporary
alias for 14 days and uses a 307 redirect; after that, the username may be claimed by anyone.

Private application, authentication, provider callback, and tokenized access routes remain on
`app.example.com` and are not username-scoped. Legacy public routes must redirect to their current
canonical creator URL instead of being removed.
