function r(e){const n=String(e??"").trim(),t=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(n);return t?Number(t[1])*60+Number(t[2]):null}export{r as c};
