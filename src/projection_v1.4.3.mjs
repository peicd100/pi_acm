// Counting-only projection. Raw session/request messages, tool IDs and signatures
// are NEVER replaced. Mirrors Pi 1.1 Responses transformMessages + serializer:
// same provider/api/model may replay signed thinking; foreign signed/redacted
// thinking cannot replay, but its non-redacted visible summary becomes text.
// No host subpath imports: CLI Git installs do not bundle host SDK dependencies.
export const COUNTING_RULE='responses-target-projection-v1';
const responses=new Set(['openai-responses','openai-codex-responses','azure-openai-responses']);
export function targetFromKey(key) {
  try{const [provider,api,id]=JSON.parse(key);if([provider,api,id].every(v=>typeof v==='string'&&v.length))return {provider,api,id};}catch{}
  return null;
}
export function projectionSupported(target){return !!target&&responses.has(target.api);}
export function projectForCount(message,target) {
  // Other/custom APIs keep the old conservative basis until their serializer
  // contract is audited; unknown compatibility must not lower a safety budget.
  if(!projectionSupported(target)||message.role!=='assistant'||!Array.isArray(message.content))return message;
  const same=message.provider===target.provider&&message.api===target.api&&message.model===target.id;
  const content=message.content.flatMap(block=>{
    if(block.type!=='thinking')return [block];
    if(same){
      if(block.thinkingSignature && typeof block.thinkingSignature!=='string')throw new Error('Malformed same-route thinking signature; context preserved');
      // Responses ignores unsigned thinking, including visible summaries.
      return block.thinkingSignature?[block]:[];
    }
    if(block.redacted||typeof block.thinking!=='string'||!block.thinking.trim())return [];
    return [{type:'text',text:block.thinking}];
  });
  return {...message,content};
}
export function visibleBasis(message,baseCounter,target) {
  const projected=projectForCount(message,target);
  if(projectionSupported(target)&&projected.role==='assistant'&&Array.isArray(projected.content)&&projected.content.length===0)return 0;
  return baseCounter.tokens(projected);
}
