function panelHarness(onPreview) {
  return () => {
    let receive, disposed;
    const panel = {
      onDidDispose:fn => {disposed=fn;return {dispose(){disposed=undefined;}};},
      dispose:() => disposed?.(),
      webview:{
        onDidReceiveMessage:fn => {receive=fn;return {dispose(){receive=undefined;}};},
        set html(value) {
          const data=JSON.parse(value.match(/const data=(.*);/)[1]);
          queueMicrotask(async () => {
            try {
              const indices=await onPreview(data);
              receive?.(indices === undefined ? {type:'cancel'} : {type:'apply',indices});
            } catch(error) { disposed?.(); throw error; }
          });
        }
      }
    };
    return panel;
  };
}
module.exports={panelHarness};
