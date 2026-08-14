console.log("start");
const express = require("express");
console.log("express ok");
const app = express();
app.get("/health", (req,res)=>res.json({ok:true}));
app.listen(8899, () => console.log("mini listening"));
