import * as cdk from "@aws-cdk/core";
import eks = require("@aws-cdk/aws-eks");
import s3 = require("@aws-cdk/aws-s3");
import * as ssm from "@aws-cdk/aws-ssm";
import iam = require("@aws-cdk/aws-iam");
import {
  CodePipeline,
  CodePipelineSource,
  ShellStep,
  ManualApprovalStep,
  CodeBuildStep,
} from "@aws-cdk/pipelines";
import { EksClusterStage } from "./eks-cluster-stage";
import { AppDnsStage } from "./app-dns-stage";

export class EksPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // const pipeline = new CodePipeline(this, "Pipeline", {
    //   synth: new ShellStep("Synth", {
    //     input: CodePipelineSource.gitHub(
    //       "srethira/aws-cdk-pipelines-eks-cluster",
    //       "main",
    //       {
    //         authentication:
    //           cdk.SecretValue.secretsManager("github-oauth-token"),
    //       }
    //     ),
    //     commands: ["npm ci", "npm run build", "npx cdk synth"],
    //   }),
    //   pipelineName: "EKSClusterBlueGreen",
    //   codeBuildDefaults: {
    //     rolePolicy: [
    //           new iam.PolicyStatement({
    //             actions: ['sts:AssumeRole'],
    //             resources: ['*'],
    //             conditions: {
    //               StringEquals: {
    //                 'iam:ResourceTag/aws-cdk:bootstrap-role': 'lookup',
    //               },
    //             },
    //           }),
    //     ],
    //   },
    // });
    
    const bucket = s3.Bucket.fromBucketName(this, 'Bucket', 'medtronic-cdk-eks');
    
    const pipeline = new CodePipeline(this, 'Pipeline', {
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.s3(bucket, 'gitsource/aws-cdk-pipelines-eks-cluster-main.zip'),
        commands: [
          // Commands to load cdk.context.json from somewhere here
          'cd aws-cdk-pipelines-eks-cluster-main',
          'ls -lrt',
          'npm ci',
          'npm run build',
          'npm i constructs @aws-cdk/assets @aws-cdk/region-info',
          'npx cdk synth',
          // Commands to store cdk.context.json back here
        ],
        primaryOutputDirectory: 'aws-cdk-pipelines-eks-cluster/cdk.out',
      }),
      pipelineName: "EKSClusterBlueGreen",
      codeBuildDefaults: {
        rolePolicy: [
              new iam.PolicyStatement({
                actions: ['sts:AssumeRole'],
                resources: ['*'],
                conditions: {
                  StringEquals: {
                    'iam:ResourceTag/aws-cdk:bootstrap-role': 'lookup',
                  },
                },
              }),
        ],
      },
    });
    
    const clusterANameSuffix = "blue";
    const clusterBNameSuffix = "green";

    const eksClusterStageA = new EksClusterStage(this, "EKSClusterA", {
      clusterVersion: eks.KubernetesVersion.V1_20,
      nameSuffix: clusterANameSuffix,
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      },
    });

    const eksClusterStageB = new EksClusterStage(this, "EKSClusterB", {
      clusterVersion: eks.KubernetesVersion.V1_21,
      nameSuffix: clusterBNameSuffix,
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      },
    });

    const eksClusterWave = pipeline.addWave("DeployEKSClusters");

    const domainName = ssm.StringParameter.valueForStringParameter(
      this,
      "/eks-cdk-pipelines/zoneName"
    );

    eksClusterWave.addStage(eksClusterStageA, {
      post: [
        new ShellStep("Validate App", {
          commands: [
            `for i in {1..12}; do curl -Ssf http://echoserver.${clusterANameSuffix}.${domainName} && echo && break; echo -n "Try #$i. Waiting 10s...\n"; sleep 10; done`,
          ],
        }),
      ],
    });

    eksClusterWave.addStage(eksClusterStageB, {
      post: [
        new ShellStep("Validate App", {
          commands: [
            `for i in {1..12}; do curl -Ssf http://echoserver.${clusterBNameSuffix}.${domainName} && echo && break; echo -n "Try #$i. Waiting 10s...\n"; sleep 10; done`,
          ],
        }),
      ],
    });

    const prodEnv = clusterBNameSuffix;

    const appDnsStage = new AppDnsStage(this, "UpdateDNS", {
      envName: prodEnv,
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      },
    });

    pipeline.addStage(appDnsStage, {
      pre: [new ManualApprovalStep(`Promote-${prodEnv}-Environment`)],
    });
  }
}
