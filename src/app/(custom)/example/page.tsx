// @polsia:user-owned — worked client data-plane example. Copy the shape for a
// real resource, then delete this page.
'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-client';
import { ExampleCreate, ExampleItem, ExampleList } from '@/lib/contracts/example';
import { applyServerErrors } from '@/lib/forms';

// The form submits the write shape; the list stores the persisted read shape.
type ExampleFormValues = ExampleCreate;

export default function ExamplePage() {
  const [items, setItems] = useState<ExampleItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const form = useForm<ExampleFormValues>({
    resolver: zodResolver(ExampleCreate),
    defaultValues: { name: '' },
  });

  useEffect(() => {
    let active = true;
    apiFetch('/api/example', { schema: ExampleList })
      .then((data) => {
        if (active) {
          setItems(data.items);
        }
      })
      .catch(() => {
        if (active) {
          setLoadError('Could not load examples.');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const created = await apiFetch('/api/example', {
        method: 'POST',
        body: JSON.stringify(values),
        schema: ExampleItem,
      });
      setItems((prev) => [...prev, created]);
      form.reset({ name: '' });
      toast.success(`Added “${created.name}”.`);
    } catch (err) {
      // Field-level server validation stays inline; generic failures go to toast.
      const applied = err instanceof Error && applyServerErrors(err.cause, form.setError);
      if (!applied) {
        toast.error('Something went wrong. Please try again.');
      }
    }
  });

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      <Card>
        <CardHeader>
          <CardTitle>Examples</CardTitle>
          <CardDescription>The full API-calls loop, end to end.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <Form {...form}>
            <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Adding…' : 'Add example'}
              </Button>
            </form>
          </Form>

          <div className="flex flex-col gap-2">
            {loadError ? (
              <p className="text-sm text-destructive">{loadError}</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No examples yet.</p>
            ) : (
              items.map((item) => (
                <div key={item.id} className="rounded-md border bg-muted/40 px-4 py-2 text-sm">
                  {item.name}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
