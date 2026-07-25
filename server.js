const express = require('express');
const fs = require('fs');
const path = require('path');
const { CodePipelineClient, GetPipelineStateCommand, ListPipelineExecutionsCommand } = require('@aws-sdk/client-codepipeline');
const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand } = require('@aws-sdk/client-codebuild');
const { ECSClient, DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand } = require('@aws-sdk/client-ecs');

const app = express();
const PORT = process.env.PORT || 80;
const REGION = process.env.AWS_REGION || 'ap-south-1';

const PIPELINE_NAME = '2048-pipeline';
const BUILD_PROJECT = '2048-build';
const ECS_CLUSTER = '2048-cluster';
const ECS_SERVICE = '2048-service';

const codepipeline = new CodePipelineClient({ region: REGION });
const codebuild = new CodeBuildClient({ region: REGION });
const ecs = new ECSClient({ region: REGION });

// Static fallback baked in at build time by buildspec.yml (this IS "Option A")
function readBuildTimeMetadata() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'build-metadata.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {
      commitSha: 'unknown',
      buildId: 'unknown',
      buildTime: 'unknown',
      note: 'build-metadata.json missing - buildspec did not generate it'
    };
  }
}

// Wrap any promise with a timeout so a stalled AWS call never hangs the page
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

async function getLivePipelineStatus() {
  const state = await withTimeout(
    codepipeline.send(new GetPipelineStateCommand({ name: PIPELINE_NAME })),
    3000, 'GetPipelineState'
  );
  const executions = await withTimeout(
    codepipeline.send(new ListPipelineExecutionsCommand({ pipelineName: PIPELINE_NAME, maxResults: 5 })),
    3000, 'ListPipelineExecutions'
  );

  const stages = (state.stageStates || []).map(s => ({
    stageName: s.stageName,
    status: s.latestExecution ? s.latestExecution.status : 'UNKNOWN'
  }));

  const history = (executions.pipelineExecutionSummaries || []).map(e => ({
    executionId: e.pipelineExecutionId,
    status: e.status,
    startTime: e.startTime,
    lastUpdateTime: e.lastUpdateTime
  }));

  return { stages, history };
}

async function getLiveBuildStatus() {
  const list = await withTimeout(
    codebuild.send(new ListBuildsForProjectCommand({ projectName: BUILD_PROJECT })),
    3000, 'ListBuildsForProject'
  );
  const latestId = (list.ids || [])[0];
  if (!latestId) return null;

  const builds = await withTimeout(
    codebuild.send(new BatchGetBuildsCommand({ ids: [latestId] })),
    3000, 'BatchGetBuilds'
  );
  const b = (builds.builds || [])[0];
  if (!b) return null;

  return {
    buildId: b.id,
    buildStatus: b.buildStatus,
    startTime: b.startTime,
    endTime: b.endTime,
    sourceVersion: b.sourceVersion
  };
}

async function getLiveEcsStatus() {
  const services = await withTimeout(
    ecs.send(new DescribeServicesCommand({ cluster: ECS_CLUSTER, services: [ECS_SERVICE] })),
    3000, 'DescribeServices'
  );
  const svc = (services.services || [])[0];
  if (!svc) return null;

  const taskList = await withTimeout(
    ecs.send(new ListTasksCommand({ cluster: ECS_CLUSTER, serviceName: ECS_SERVICE })),
    3000, 'ListTasks'
  );

  let taskDetails = [];
  if (taskList.taskArns && taskList.taskArns.length > 0) {
    const tasks = await withTimeout(
      ecs.send(new DescribeTasksCommand({ cluster: ECS_CLUSTER, tasks: taskList.taskArns })),
      3000, 'DescribeTasks'
    );
    taskDetails = (tasks.tasks || []).map(t => ({
      taskArn: t.taskArn.split('/').pop(),
      lastStatus: t.lastStatus,
      healthStatus: t.healthStatus,
      startedAt: t.startedAt
    }));
  }

  return {
    desiredCount: svc.desiredCount,
    runningCount: svc.runningCount,
    pendingCount: svc.pendingCount,
    deploymentStatus: (svc.deployments || []).map(d => ({
      status: d.status,
      taskDefinition: (d.taskDefinition || '').split('/').pop(),
      desiredCount: d.desiredCount,
      runningCount: d.runningCount,
      updatedAt: d.updatedAt
    })),
    tasks: taskDetails
  };
}

app.get('/api/status', async (req, res) => {
  const buildMeta = readBuildTimeMetadata();
  const response = { source: 'live', buildMeta };

  try {
    const [pipeline, build, ecsStatus] = await Promise.all([
      getLivePipelineStatus().catch(e => ({ error: e.message })),
      getLiveBuildStatus().catch(e => ({ error: e.message })),
      getLiveEcsStatus().catch(e => ({ error: e.message }))
    ]);
    response.pipeline = pipeline;
    response.build = build;
    response.ecs = ecsStatus;
  } catch (e) {
    // Total failure of live calls - fall back entirely to build-time metadata (Option A)
    response.source = 'fallback';
    response.error = e.message;
  }

  res.json(response);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Dashboard listening on port ${PORT}`));
