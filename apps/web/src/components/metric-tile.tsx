import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type MetricTileProps = {
  title: string;
  value: string;
  description: string;
};

export function MetricTile({ title, value, description }: MetricTileProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
