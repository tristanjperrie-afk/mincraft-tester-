import os, secrets, httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
app=FastAPI(title="OmniAI")
PAGE=open(os.path.join(os.path.dirname(__file__),"index.html"),encoding="utf-8").read()
class Chat(BaseModel):
    provider:str
    api_key:str
    model:str
    prompt:str
    base_url:str|None=None
def auth(token):
    expected=os.getenv("OMNIAI_ACCESS_TOKEN","")
    if not expected or not token or not secrets.compare_digest(token,expected):
        raise HTTPException(401,"Enter the Render-generated OmniAI access token.")
@app.get("/",response_class=HTMLResponse)
def home(): return PAGE
@app.get("/health")
def health(): return {"ok":True,"service":"OmniAI","version":"cloud-alpha"}
@app.post("/api/chat")
async def chat(body:Chat,x_omniai_token:str|None=Header(default=None)):
    auth(x_omniai_token)
    if not body.api_key or not body.model or not body.prompt.strip(): raise HTTPException(400,"Provider key, model, and prompt are required.")
    async with httpx.AsyncClient(timeout=120) as c:
        if body.provider=="claude":
            r=await c.post("https://api.anthropic.com/v1/messages",headers={"x-api-key":body.api_key,"anthropic-version":"2023-06-01","content-type":"application/json"},json={"model":body.model,"max_tokens":4096,"messages":[{"role":"user","content":body.prompt}]})
        elif body.provider in ("openai","hark"):
            base=(body.base_url or "https://api.openai.com/v1").rstrip("/")
            r=await c.post(base+"/chat/completions",headers={"Authorization":"Bearer "+body.api_key,"Content-Type":"application/json"},json={"model":body.model,"messages":[{"role":"user","content":body.prompt}]})
        else: raise HTTPException(400,"Unsupported provider.")
    if r.is_error: raise HTTPException(r.status_code,"Provider error: "+r.text[:1000])
    data=r.json()
    if body.provider=="claude": answer="".join(x.get("text","") for x in data.get("content",[]) if x.get("type")=="text")
    else: answer=data.get("choices",[{}])[0].get("message",{}).get("content","")
    return {"answer":answer}
