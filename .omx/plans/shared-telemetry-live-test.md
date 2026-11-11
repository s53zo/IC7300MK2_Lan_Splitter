# Approved shared telemetry and live test

User: S-meter and RX/TX100ms; ADC overflow500ms; Power/SWR/ALC100ms onlyTX.
User explicitly confirmed dummyload and authorized up to60s TX at10W. Parent
chooses20s steadyTX withindependent30s service-stopwatchdog; no RF bysubagents.

Implementation: opt-in telemetryEnabled, globalcachemaster respected; family/
query0optsoutsharing (freshRXTXsafety100mscontinueswhenmodeactive), positive
legacyTTLs retainedbutpooluses300msfast/1000msADCmaxage. One in-flightjob/key,
no catchupbursts, safetypriority, FIFO exceptionscold/stale/invalidated counted.
ActualTXproof fromvalidated1c00; freshRXpermitsdocumentedzeroTXmeterreplies.
Freshsafetyevaluation retains500msstableRX+incarnation/grace; no cache-safetyloop.
Alllocalanswercounters separatedfrompaidbackgroundradio reads.

Validation:262tests+independentaudit+ordinarybrowser captures; Rxbaseline60s
onold94c recordedzero source/downstreamloss andnoaudio gaps>=100ms. Rawmedia
isnotretained. StagefullsourceonPi,runARMtests beforeactivation; deployversioned
source rollbackprevious94c; enableonlynewprofileflagviaauthHTTPS+confirmedRX
reconnect; retainexistingallotherparameters/credentials/TLScert/unit. InitialRX20s
thenRX60s compareaudio/scope gaps, sourceandnative lost/replay/timeouts andactual
perquerypollrates. Onfailure rollbackflag/release ratherthanpersistbadload.
SyntheticTXrates52/s beforelive. LiveTX20s nominal10Wrelative25/255FMcarrier,
readbackpower/mode first, independentwatchdog, PTToff+confirmedRXthenrestore
originalmode/data/filter/powerconditionally; neverchangefrequency. ExcludeRX↔TX
transitionaudiomute fromdropoutclaims; recordTXscope/control/transport andverify
RXaudio resumes. RecheckRXaftertest. Do notpublishnewstabletagwithoutrequest.

Owners: corebroker/module/tests; independentaudit tests; probeRXmetadata;
RFhelperoptin+watchdog/tests; UI3files+semantic tests; parentconfig/metrics/TUI/
docs/integration/deploy/actualoperator-authorizedRFonly.
