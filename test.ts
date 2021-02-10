// See https://deno.land/manual/testing
import { assertEquals } from "./deps.ts"

Deno.test("hello world #1", () => {
    const x = 1 + 2
    assertEquals(x, 3)
})

Deno.test("hello world #2", () => {
    const x = 2 + 2
    assertEquals(x, 4)
})

Deno.test("hello world #3", () => {
    const x = 3 + 2
    assertEquals(x, 5)
})
