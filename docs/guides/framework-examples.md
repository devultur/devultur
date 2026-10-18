# Framework examples

Wire the server SDK into TanStack Start or Next.js to generate presigned upload URLs.

`createUploadUrl` runs on the server. Expose it through your framework's server
function or route handler.

## TanStack Start

```typescript
// app/routes/api/media.ts
import { createServerFn } from "@tanstack/react-start";
import { media } from "@/lib/media";

export const getUploadUrl = createServerFn({ method: "POST" })
  .validator((data: { filename: string; type: string }) => data)
  .handler(async ({ data }) => {
    return media.createUploadUrl({
      filename: data.filename,
      contentType: data.type,
    });
  });
```

## Next.js App Router

```typescript
// app/api/media/upload/route.ts
import { media } from "@/lib/media";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { filename, type } = await request.json();
  const result = await media.createUploadUrl({ filename, contentType: type });
  return NextResponse.json(result);
}
```
