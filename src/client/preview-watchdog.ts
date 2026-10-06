/** A stalled render remains bounded even when playback keeps sending frames. */
export class RenderWatchdog {
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private onTimeout:()=>void,private timeoutMs=10000){}
  arm():void{if(this.timer!==undefined)return;this.timer=setTimeout(()=>{this.timer=undefined;this.onTimeout();},this.timeoutMs);}
  acknowledge():void{if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
  dispose():void{this.acknowledge();}
}
