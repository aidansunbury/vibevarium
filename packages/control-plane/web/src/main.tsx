import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { isUnauthenticated, login } from "./api";
import "./index.css";

// No unauthed state: ANY 401 — a route loader or a page query — bounces the
// browser straight to the auth server. The query-cache subscription covers
// queries failing inside pages (the integrations-page decode bug); the
// router's defaultErrorComponent covers route loads.
const bounceOnUnauthenticated = (error: unknown) => {
  if (isUnauthenticated(error)) login();
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: bounceOnUnauthenticated,
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !isUnauthenticated(error) && failureCount < 2,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultErrorComponent: ({ error }) => {
    if (isUnauthenticated(error)) {
      login();
      return null;
    }
    throw error;
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
