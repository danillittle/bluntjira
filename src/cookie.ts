import { z } from "zod";

// The login response and server configuration must accept the same cookie format.
export const sessionCookieSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/),
  value: z.string().min(1).refine((value) => [...value].every((char) =>
    char.charCodeAt(0) > 32 && char.charCodeAt(0) < 127 && char !== ";")),
});
