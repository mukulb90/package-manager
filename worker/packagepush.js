'use strict';

const ALLOWED_ORGS = ['00D0q000000CxI3','00D37000000KnsY', '00D37000000Knsn', '00D1I000001dehP', '00Dj0000000JprU', '00D0m0000008dxK'];

const sfdc = require('../api/sfdcconn');
const packageversions = require('../api/packageversions');
const upgrades = require('../api/upgrades');

async function createPushRequest(conn, upgradeId, packageOrgId, packageVersionId, scheduledDate) {
    let isoTime = scheduledDate ? scheduledDate.toISOString ? scheduledDate.toISOString() : scheduledDate : null;
    let body = {PackageVersionId: packageVersionId, ScheduledStartTime: isoTime};
    let pushReq = await conn.sobject("PackagePushRequest").create(body);
    return await upgrades.createUpgradeItem(upgradeId, pushReq.id, packageOrgId, packageVersionId, scheduledDate, pushReq.success ? "Created" : pushReq.errors);
}

async function createPushJob(conn, upgradeId, itemId, pushReqId, orgIds) {
    let body = [];
    for (let i = 0; i < orgIds.length; i++) {
        body.push({PackagePushRequestId: pushReqId, SubscriberOrganizationKey: orgIds[i]});
    }

    let results = await conn.sobject("PackagePushJob").create(body);
    
    let jobs = [];
    for (let i = 0; i < results.length; i++) {
        jobs.push({org_id: orgIds[i], job_id: results[i].id, status: results[i].success ? "Created" : results[i].errors});
    }

    await upgrades.createUpgradeJobs(upgradeId, itemId, pushReqId, jobs);
}

async function cancelRequests(conn) {
    let res = await conn.query("SELECT Id,PackageVersionId,Status,ScheduledStartTime FROM PackagePushRequest WHERE Status = 'Created'");
    console.log(`Canceling: ${res.records.length} requests`);
    let canceled = res.records.map((v) => {
        return conn.sobject('PackagePushRequest').update({Id: v.Id, Status: "Canceled"});
    });
    res = await Promise.all(canceled);
    console.log(`Canceled: ${res.records.length} requests`);
}

async function clearRequests(packageOrgIds) {
    for (let i = 0; i < packageOrgIds.length; i++) {
        let conn = await sfdc.buildOrgConnection(packageOrgIds[i]);
        await cancelRequests(conn);
    }
}

async function updatePushRequests(upgradeItemIds, status) {
    let conns = {}, batches = {};

    let items = await upgrades.findItemsByIds(upgradeItemIds);
    for (let i = 0; i < items.length; i++) {
        let item = items[i];
        let conn = conns[item.package_org_id] = conns[item.package_org_id] || await sfdc.buildOrgConnection(item.package_org_id);
        let batch = batches[item.push_request_id] = (batches[item.push_request_id] || {conn: conn, requests: []});
        batch.requests.push({Id: item.push_request_id, Status: status});
    }

    // Now, just update requests.
    let promises = [];
    Object.entries(batches).forEach(([key, batch]) => {
        promises.push(batch.conn.sobject('PackagePushRequest').update(batch.requests));
    });
    return await Promise.all(promises);
}

async function upgradeOrgs(orgIds, versionIds, scheduledDate, description) {
    for (let i = 0; i < orgIds.length; i++) {
        if (ALLOWED_ORGS.indexOf(orgIds[i]) === -1) {
            throw new Error(`${orgIds[i]} is not in ALLOWED_ORGS.  Aborting operation.  Shame on you.`);
        }
    }

    let upgrade = await upgrades.createUpgrade(scheduledDate, description);

    let versions = await packageversions.findLatestByOrgIds(versionIds, orgIds);
    for (let i = 0; i < versions.length; i++) {
        let version = versions[i];
        let conn = await sfdc.buildOrgConnection(version.package_org_id);
        let item = await createPushRequest(conn, upgrade.id, version.package_org_id, version.latest_version_id, scheduledDate);
        await createPushJob(conn, upgrade.id, item.id, item.push_request_id, orgIds);
    }
    return upgrade;
}

async function upgradeOrgGroups(orgGroupIds, versionIds, scheduledDate, description) {
    let conns = {}, pushReqs = {};

    let upgrade = await upgrades.createUpgrade(scheduledDate, description);

    let versions = await packageversions.findLatestByGroupIds(versionIds, orgGroupIds);
    for (let i = 0; i < versions.length; i++) {
        let version = versions[i];
        let orgKey = version.package_org_id, reqKey = version.package_org_id + version.latest_version_id;

        let conn = conns[orgKey] = conns[orgKey] || await sfdc.buildOrgConnection(version.package_org_id);

        let pushReq = pushReqs[reqKey] = pushReqs[reqKey] || // Initialized if not found
            {item: await createPushRequest(conn, upgrade.id, version.package_org_id, version.latest_version_id, scheduledDate), conn: conn, orgIds: []};

        // Add this particular org id to the batch
        pushReq.orgIds.push(version.org_id);
    }

    // Now, create the jobs and activate the requests.
    Object.entries(pushReqs).forEach(async ([key, pushReq]) => {
        await createPushJob(pushReq.conn, upgrade.id, pushReq.item.id, pushReq.item.push_request_id, pushReq.orgIds);
    });

    return upgrade;
}

async function upgradeVersion(versionId, orgIds, scheduledDate, description) {
    let version = await packageversions.findLatestByOrgIds([versionId], orgIds)[0];
    let conn = await sfdc.buildOrgConnection(version.package_org_id);

    let upgrade = await upgrades.createUpgrade(scheduledDate, description);

    let item = await createPushRequest(conn, upgrade.id, version.package_org_id, version.latest_version_id, scheduledDate);
    await createPushJob(conn, upgrade.id, item.id, item.push_request_id, orgIds);

    return upgrade;
}

async function findRequestsByStatus(packageOrgId, status) {
    let conn = await sfdc.buildOrgConnection(packageOrgId);

    let soql = `SELECT Id,PackageVersionId,Status,ScheduledStartTime 
        FROM PackagePushRequest 
        WHERE Status IN (${status.map(v => `'${v}'`).join(",")})`;

    let res = await conn.query(soql);
    return res.records;
}

async function findRequestsByIds(packageOrgId, requestIds) {
    let conn = await sfdc.buildOrgConnection(packageOrgId);

    let params = requestIds.map(v => `'${v}'`);
    let soql = `SELECT Id,PackageVersionId,Status,ScheduledStartTime 
        FROM PackagePushRequest 
        WHERE Id IN (${params.join(",")})`;

    let res = await conn.query(soql);
    return res.records;
}

async function findJobsByStatus(packageOrgId, requestIds, status) {
    let conn = await sfdc.buildOrgConnection(packageOrgId);

    let soql = `SELECT Id,PackagePushRequestId,Status,SubscriberOrganizationKey 
        FROM PackagePushJob
        WHERE PackagePushRequestId IN (${status.map(v => `'${v}'`).join(",")})
        AND Status IN (${status.map(v => `'${v}'`).join(",")})`;

    let res = await conn.query(soql);
    return res.records;
}

async function findJobsByRequestIds(packageOrgId, requestIds) {
    let conn = await sfdc.buildOrgConnection(packageOrgId);

    let params = requestIds.map(v => `'${v}'`);
    let soql = `SELECT Id,PackagePushRequestId,Status,SubscriberOrganizationKey 
        FROM PackagePushJob
        WHERE PackagePushRequestId IN (${params.join(",")})`;

    let res = await conn.query(soql);
    return res.records;
}

async function findErrorsByJobIds(packageOrgId, jobIds) {
    let conn = await sfdc.buildOrgConnection(packageOrgId);

    let params = jobIds.map(v => `'${v}'`);
    let soql = `SELECT Id,ErrorDetails,ErrorMessage,ErrorSeverity,ErrorTitle,ErrorType,PackagePushJobId 
        FROM PackagePushError
        WHERE PackagePushJobId IN (${params.join(",")})`;

    let res = await conn.query(soql);
    return res.records;
}

exports.findRequestsByStatus = findRequestsByStatus;
exports.findRequestsByIds = findRequestsByIds;
exports.findJobsByStatus = findJobsByStatus;
exports.findJobsByRequestIds = findJobsByRequestIds;
exports.findErrorsByJobIds = findErrorsByJobIds;
exports.updatePushRequests = updatePushRequests;
exports.clearRequests = clearRequests;
exports.upgradeOrgs = upgradeOrgs;
exports.upgradeOrgGroups = upgradeOrgGroups;
exports.upgradeVersion = upgradeVersion;