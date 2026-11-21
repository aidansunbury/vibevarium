import { runConnectionsDemo } from "../src/demo.ts"

const report = await runConnectionsDemo()
console.log(JSON.stringify(report, null, 2))
