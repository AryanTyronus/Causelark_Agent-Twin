// @polsia:framework-owned — DO NOT EDIT. Bridges a route handler's 400 body
// onto react-hook-form so server-side field validation surfaces on the form.
//
// ROUTE 400 CONTRACT this consumes (emit exactly one of these from a handler
// when validation fails):
//   A) flat map  — { errors: { <field>: '<message>' } }   (preferred shape;
//      this is what the reference route at src/app/api/example/route.ts emits)
//   B) zod shape — { errors: { fieldErrors: { <field>: ['<message>', ...] } } }
//      i.e. the result of `zodError.flatten()`. Useful if a handler forwards a
//      flatten() verbatim. The first message per field is used.
// Anything else is ignored (the caller should fall back to a generic toast).
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { z } from 'zod';

// Shape A: flat field -> message.
const flatErrors = z.record(z.string(), z.string());
// Shape B: zod flatten() — formErrors[] + fieldErrors{ field: string[] }.
const flattenErrors = z.object({
  formErrors: z.array(z.string()).optional(),
  fieldErrors: z.record(z.string(), z.array(z.string())),
});
// The 400 envelope: { errors: A | B }.
const errorBody = z.object({
  errors: z.union([flattenErrors, flatErrors]),
});

/**
 * Map a route handler's 400 body onto react-hook-form field errors.
 *
 * @returns true if at least one field error was applied (so the caller can skip
 *   a generic error toast), false if the body did not match the 400 contract.
 */
export function applyServerErrors<TFieldValues extends FieldValues>(
  body: unknown,
  setError: UseFormSetError<TFieldValues>,
): boolean {
  const parsed = errorBody.safeParse(body);
  if (!parsed.success) {
    return false;
  }

  const { errors } = parsed.data;
  // Normalise both shapes to a flat field -> first-message map.
  const flat: Record<string, string> =
    'fieldErrors' in errors
      ? Object.fromEntries(
          Object.entries(errors.fieldErrors)
            .map(([field, messages]) => [field, messages[0]])
            .filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
      : errors;

  let applied = false;
  for (const [field, message] of Object.entries(flat)) {
    setError(field as Path<TFieldValues>, { type: 'server', message });
    applied = true;
  }
  return applied;
}
